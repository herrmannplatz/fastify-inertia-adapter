import neostandard from 'neostandard'

export default neostandard({
  semi: false,
  ignores: ['dist/**/*', 'example/dist/**/*', 'node_modules/**/*', 'coverage/**/*'],
  ts: true,
})
