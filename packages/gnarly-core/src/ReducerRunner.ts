import makeDebug = require('debug')

import Blockstream from './Blockstream'
import { globalState } from './globalstate'
import Block, { IJSONBlock } from './models/Block'
import Ourbit, {
  IOperation,
  IPatch,
} from './ourbit'
import { IReducer, ReducerType } from './reducer'
import {
  SetdownFn,
  SetupFn,
  TypeStorer,
} from './typeStore'
import { parsePath } from './utils'

class ReducerRunner {
  public ourbit: Ourbit
  public blockstreamer: Blockstream
  public shouldResume: boolean = true

  private debug

  constructor (
    private reducer: IReducer,
  ) {

    this.debug = makeDebug(`gnarly-core:runner:${reducer.config.key}`)

    this.ourbit = new Ourbit(
      reducer.config.key,
      this.reducer.state,
      this.persistPatchHandler,
    )

    this.blockstreamer = new Blockstream(
      this.ourbit,
      this.handleNewBlock,
    )
  }

  public run = async (fromBlockHash: string) => {
    let latestBlockHash = null

    switch (this.reducer.config.type) {
      // idempotent reducers are only called from HEAD
      case ReducerType.Idempotent:
        latestBlockHash = null
        break
      // TimeVarying and Atomic Reducers start from a provided block hash, the latest in the DB, or HEAD
      case ReducerType.TimeVarying:
      case ReducerType.Atomic: {
        if (this.shouldResume) {
          // we're resuming, so replay from store if possible
          try {
            const latestTransaction = await globalState.store.getLatestTransaction()
            latestBlockHash = latestTransaction ? latestTransaction.blockHash : null

            this.debug('Attempting to reload state from %s', latestBlockHash || 'HEAD')

            // let's re-hydrate local state by replaying transactions
            await this.ourbit.resumeFromTxId(latestBlockHash)
          } catch (error) {
            this.debug('No latest transaction, so we\'re definitely starting from scratch')
          }
        } else {
          // we reset, so let's start from HEAD
          latestBlockHash = fromBlockHash || null
          this.debug('Explicitely starting from %s', latestBlockHash || 'HEAD')
        }
        break
      }
      default:
        throw new Error(`Unexpected ReducerType ${this.reducer.config.type}`)
    }

    // and now ingest blocks from latestBlockHash
    await this.blockstreamer.start(latestBlockHash)

    return this.stop.bind(this)
  }

  public stop = async () => {
    await this.blockstreamer.stop()
  }

  public reset = async (shouldReset: boolean = true) => {
    this.shouldResume = !shouldReset
    if (shouldReset) {
      const setdown = this.reducer.config.typeStore.__setdown as SetdownFn
      await setdown()
    }

    const setup = this.reducer.config.typeStore.__setup as SetupFn
    await setup()
  }

  private handleNewBlock = (rawBlock: IJSONBlock, syncing: boolean) => async () => {
    const block = await this.normalizeBlock(rawBlock)
    await this.reducer.reduce(this.reducer.state, block)
  }

  private normalizeBlock = async (block: IJSONBlock): Promise<Block> => {
    return new Block(block)
  }

  private persistPatchHandler = async (txId: string, patch: IPatch) => {
    for (const op of patch.operations) {
      await this.persistOperation(patch.id, op)
    }
  }

  private persistOperation = async (patchId: string, operation: IOperation) => {
    const { scope } = parsePath(operation.path)
    const storer = this.reducer.config.typeStore.store as TypeStorer
    await storer(patchId, operation)
  }
}

export const makeRunner = (
    reducer: IReducer,
  ) => new ReducerRunner(
    reducer,
  )

export default ReducerRunner
