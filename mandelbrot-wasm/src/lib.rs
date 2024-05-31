use wasm_bindgen::prelude::*;

const MAP_SCALE: f64 = 16.0;
const MAP_OFFSET: f64 = -8.0;

const BAILOUT: f64 = 24.0;
const PERIODICITY_THRESHOLD: f64 = 1e-12;
const CYCLE_DETECTION_DELAY: f64 = 40.0;
const CYCLE_MEMORY_INTERVAL: i32 = 20;

fn is_in_cardioid_or_bulb(x: f64, y: f64) -> bool {
    let y2 = y * y;
    let q = (x - 0.25).powi(2) + y2;
    let in_cardioid = q * (q + (x - 0.25)) < 0.25 * y2;
    let in_bulb = (x + 1.0).powi(2) + y2 < 0.0625;

    return in_cardioid || in_bulb;
}

fn escape_time(cx: f64, cy: f64, max_iterations: f64) -> f32 {
    let mut zx = 0.0;
    let mut zy = 0.0;
    let mut x2 = 0.0;
    let mut y2 = 0.0;
    let mut cycle_x = 0.0;
    let mut cycle_y = 0.0;

    let mut i: f64 = 0.0;
    while i < max_iterations {
        for _ in 0..CYCLE_MEMORY_INTERVAL {
            if x2 + y2 > BAILOUT {
                return (i + 2.0 - (x2 + y2).ln().ln() / 2f64.ln()) as f32;
            }

            zy = (zx + zx) * zy + cy;
            zx = x2 - y2 + cx;
            x2 = zx * zx;
            y2 = zy * zy;
            i += 1.0;

            if i >= CYCLE_DETECTION_DELAY {
                if (zx - cycle_x).abs() < PERIODICITY_THRESHOLD
                    && (zy - cycle_y).abs() < PERIODICITY_THRESHOLD
                {
                    return 0.0;
                }
            }
        }

        cycle_x = zx;
        cycle_y = zy;
    }

    return 0.0;
}

#[wasm_bindgen]
pub fn get_mandelbrot_tile(z: f64, x: f64, y: f64, size: f64, max_iters: f64) -> Vec<f32> {
    let scale = MAP_SCALE * 2f64.powf(-z);
    let offset_x = x * scale + MAP_OFFSET;
    let offset_y = y * scale + MAP_OFFSET;

    let mut iters_tile = vec![0.0; (size * size) as usize];

    for pixel_x in 0..size as i32 {
        let cx = (pixel_x as f64 * scale) / size + offset_x;
        for pixel_y in 0..size as i32 {
            let cy = (pixel_y as f64 * scale) / size + offset_y;

            let pixel_idx = (pixel_y * size as i32 + pixel_x) as usize;
            if is_in_cardioid_or_bulb(cx, cy) {
                iters_tile[pixel_idx] = 0.0;
                continue;
            }

            iters_tile[pixel_idx] = escape_time(cx, cy, max_iters);
        }
    }

    return iters_tile;
}