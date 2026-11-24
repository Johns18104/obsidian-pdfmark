// pdf.js ships its public types next to the ESM bundle only; the legacy build
// we import (for the older syntax) has no declaration file adjacent to it, so
// without this mapping every pdf.js value would be `any`.
declare module "pdfjs-dist/legacy/build/pdf.js" {
  export * from "pdfjs-dist";
}
