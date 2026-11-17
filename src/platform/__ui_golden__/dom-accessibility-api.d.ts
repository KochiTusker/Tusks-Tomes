// dom-accessibility-api ships types but they do not resolve under this
// project's module resolution. Only the one function the serializer uses is
// declared.
declare module 'dom-accessibility-api' {
  export function computeAccessibleName(root: Element): string
}
