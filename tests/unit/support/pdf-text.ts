import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  type PDFObject,
} from 'pdf-lib'

/**
 * The text drawn on each page of a PDF that RecoverEase generated, line by
 * line in drawing order - enough to check what a document says without a PDF
 * renderer.
 *
 * It reads only what pdf-lib writes: each line is one `<hex> Tj` in a page's
 * content stream, in Windows-1252 (Helvetica's WinAnsi encoding). It is not a
 * general PDF text extractor.
 */
export async function pdfPages(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const decoder = new TextDecoder('windows-1252')
  return doc.getPages().map((page) => {
    const contents = page.node.Contents()
    const streams: PDFObject[] =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref)!)
        : contents
          ? [contents]
          : []
    const lines: string[] = []
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue
      const source = new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode())
      for (const match of source.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
        const hex = match[1]!
        const raw = new Uint8Array(hex.length / 2)
        for (let i = 0; i < raw.length; i += 1) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        lines.push(decoder.decode(raw))
      }
    }
    return lines
  })
}

/** Every page's lines, in order, as one list. */
export async function pdfLines(bytes: Uint8Array): Promise<string[]> {
  return (await pdfPages(bytes)).flat()
}
