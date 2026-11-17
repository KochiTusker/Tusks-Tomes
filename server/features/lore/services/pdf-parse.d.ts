declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
    numpages: number
    numrender: number
    info: unknown
    metadata: unknown
    version: string
  }
  function pdf(buffer: Buffer | Uint8Array, options?: unknown): Promise<PdfParseResult>
  export default pdf
}
