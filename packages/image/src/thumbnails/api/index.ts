/**
 * API exports
 *
 * @module
 */

export { createThumbnails, type CreateThumbnailsConfig, type ThumbnailInstance } from "./createThumbnails.js"

export {
  _broadcastThumbnailEvent,
  disposeThumbnails,
  getThumbnailState,
  initThumbnails,
  onThumbnailEvent,
  regenerateThumbnail,
  resolveThumbnailOrFileUrl,
  resolveThumbnailUrl,
  startThumbnails,
  stopThumbnails
} from "./singleton.js"
