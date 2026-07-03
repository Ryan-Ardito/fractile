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
- Bivariate linear approximation (BLA): precomposed reference-orbit blocks
  let pixels skip long stretches of iterations at once — order-of-magnitude
  faster at depth (20x+ at 10¹⁸⁰), where escape times run into the hundreds
  of thousands
- Hand-rolled WebGL2 tile engine: exact BigInt tile addressing, LRU cache,
  parent-tile fallback, fade-in transitions
- Caching (cost-aware eviction: expensive deep tiles survive until RAM
  pressure forces them out, so deep round trips replay from cache)
- Preloading (idle workers prewarm the zoom-out corridor: the central tile
  at every ancestor level first, then viewport-wide windows)
- Tile synthesis: a tile fully covered by its four cached children is built
  by GPU-subsampling them — microseconds instead of a worker computation
- Interpolation
- Async front end
- Parallel processing (persistent worker pool)
- Progressive rendering
- WebGL animated HSL colors
- Adaptive iterations: workers keep iterating just the unresolved pixels
  until no pixel is starved, and tiles teach their measured needs to their
  neighbors and children — no manual max-iteration setting at any depth
- Interior detection by hyperbolicity (orbit-derivative contraction over
  doubling windows) — scale-independent at any depth and period-agnostic,
  where epsilon-based periodicity checks paint false interiors around deep
  minibrots
- Band-limited palette (shader fades bands/hue where contours go sub-pixel
  instead of aliasing into moiré)
- Depth-invariant coloring: iteration counts are log-compressed before the
  palette, so deep views keep bands and color instead of washing out
- Location data in URL for sharing (old-format links still work)
