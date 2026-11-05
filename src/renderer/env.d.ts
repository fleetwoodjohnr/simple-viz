import type { SimpleVizApi } from '../shared/ipc-types'

declare global {
  interface Window {
    simpleViz: SimpleVizApi
  }
}
export {}
