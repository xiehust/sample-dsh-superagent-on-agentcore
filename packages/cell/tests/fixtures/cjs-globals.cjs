// A CommonJS module like the Lark SDK's: it reads __dirname / __filename and calls require() at run time.
const path = require('node:path')
module.exports = () => ({ dirname: __dirname, filename: __filename, sep: require('node:path').sep, resolved: path.resolve(__dirname, '..', 'package.json') })
