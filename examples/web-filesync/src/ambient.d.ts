/// <reference types="vite/client" />

declare module '*?worker' {
  const value: new () => Worker
  export default value
}

declare module '*?sharedworker' {
  const value: new () => SharedWorker
  export default value
}
