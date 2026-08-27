// `lib/build.mjs` loads `.icon.png` through esbuild's `dataurl` loader, so an import of one is the
// image itself as a `data:` URI. The extension is `.icon.png` and not `.png` because the build
// keeps a `file` loader on `.png` for everything else.
declare module "*.icon.png" {
  const dataUri: string;
  export default dataUri;
}
