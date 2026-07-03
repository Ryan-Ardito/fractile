# Mandelbrot Viewer

https://fractal.party

## Controls
Open the menu in the bottom left for more controls.

### Desktop

- **Click-and-drag**: Pan
- **Scroll wheel**: Zoom in/out
- **Shift + drag**: Zoom in to selected area
- **Double-click**: Zoom in
- **Space bar**: Play/pause animated colors
- **F11**: Fullscreen
- **Escape**: Close menu
- **Arrow keys**: Pan one pixel

### Mobile

- **Pinch**: Zoom in/out
- **Drag**: Pan
- **Double-tap**: Zoom in

## Features

- Deep zoom (~10²⁸⁰x) via perturbation theory: one BigInt fixed-point
  reference orbit per view, float64 delta iteration per pixel, with
  rebasing for glitch-free single-reference rendering
- Hand-rolled WebGL2 tile engine: exact BigInt tile addressing, LRU cache,
  parent-tile fallback, fade-in transitions
- Caching
- Preloading
- Interpolation
- Async front end
- Parallel processing (persistent worker pool)
- Progressive rendering
- WebGL animated HSL colors
- Adaptive iterations: workers keep iterating just the unresolved pixels
  until no pixel is starved, and tiles teach their measured needs to their
  neighbors and children — no manual max-iteration setting at any depth
- Band-limited palette (shader fades bands/hue where contours go sub-pixel
  instead of aliasing into moiré)
- Depth-invariant coloring: iteration counts are log-compressed before the
  palette, so deep views keep bands and color instead of washing out
- Location data in URL for sharing (old-format links still work)
