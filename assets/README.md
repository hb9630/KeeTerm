# Vendored frontend assets

Bundled into the binary with `include_str!` so the gateway is a single
self-contained file (works offline / air-gapped).

| file | package | license |
|---|---|---|
| `xterm.js` | [@xterm/xterm](https://github.com/xtermjs/xterm.js) | MIT |
| `xterm.css` | @xterm/xterm | MIT |
| `addon-fit.js` | [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | MIT |

These are unmodified dist builds from npm. Update with:

```
npm i @xterm/xterm @xterm/addon-fit
cp node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css .
cp node_modules/@xterm/addon-fit/lib/addon-fit.js .
```
