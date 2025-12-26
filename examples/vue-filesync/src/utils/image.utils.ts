export const invertImageFile = async (srcFile: File): Promise<File> => {
  const blobUrl = URL.createObjectURL(srcFile)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = (e) => reject(e)
      el.src = blobUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i]
      data[i + 1] = 255 - data[i + 1]
      data[i + 2] = 255 - data[i + 2]
    }
    ctx.putImageData(imageData, 0, 0)

    const editedBlob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b as Blob), srcFile.type)
    )
    return new File([editedBlob], srcFile.name, { type: srcFile.type, lastModified: Date.now() })
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
