/**
 * WebGPU device bootstrap and shared resource helpers.
 */

export async function initGpu(canvas) {
  if (!navigator.gpu) {
    return null;
  }

  let adapter =
    (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ||
    (await navigator.gpu.requestAdapter()) ||
    null;
  if (!adapter) {
    // Brief retry — some embeds report no adapter on the first call.
    await new Promise((r) => setTimeout(r, 50));
    adapter = await navigator.gpu.requestAdapter();
  }
  if (!adapter) {
    return null;
  }

  // Default device limits keep maxBufferSize at 256 MiB; cloud maps at longer
  // grids need more. Ask for the adapter's full buffer ceilings when available.
  const requiredLimits = {};
  const adapterLimits = adapter.limits;
  if (adapterLimits.maxBufferSize != null) {
    requiredLimits.maxBufferSize = adapterLimits.maxBufferSize;
  }
  if (adapterLimits.maxStorageBufferBindingSize != null) {
    requiredLimits.maxStorageBufferBindingSize =
      adapterLimits.maxStorageBufferBindingSize;
  }

  let device;
  try {
    device = await adapter.requestDevice({ requiredLimits });
  } catch {
    // Some stacks reject elevated limits; fall back to defaults.
    device = await adapter.requestDevice();
  }
  device.addEventListener("uncapturederror", (e) => {
    console.error("WebGPU uncaptured error:", e.error);
  });

  const context = canvas.getContext("webgpu");
  if (!context) {
    return null;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "opaque",
  });

  return { device, context, format, adapter };
}

/**
 * Configure a secondary canvas to share an existing WebGPU device.
 * @returns {GPUCanvasContext|null}
 */
export function configureCanvas(device, canvas, format, alphaMode = "premultiplied") {
  const context = canvas.getContext("webgpu");
  if (!context) return null;
  context.configure({
    device,
    format,
    alphaMode,
  });
  return context;
}

export function createBuffer(device, size, usage, label) {
  return device.createBuffer({ size, usage, label });
}

export function writeBuffer(device, buffer, data, offset = 0) {
  device.queue.writeBuffer(buffer, offset, data);
}

/** Round byte size up to 256 (uniform buffer min binding alignment). */
export function align256(n) {
  return (n + 255) & ~255;
}

/**
 * Read an rgba8unorm texture into a 2D canvas (for screenshots).
 * Prefer this over drawImage/createImageBitmap on a WebGPU canvas — those
 * often return black once the swapchain has moved on.
 * @param {GPUDevice} device
 * @param {GPUTexture} texture
 * @param {number} width
 * @param {number} height
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function readRgba8TextureToCanvas(device, texture, width, height) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const bytesPerPixel = 4;
  const unpaddedRow = w * bytesPerPixel;
  const bytesPerRow = align256(unpaddedRow);
  const buffer = device.createBuffer({
    label: "texture-readback",
    size: bytesPerRow * h,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: "texture-readback" });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow },
    { width: w, height: h }
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buffer.getMappedRange());
  const rgba = new Uint8ClampedArray(w * h * bytesPerPixel);
  if (bytesPerRow === unpaddedRow) {
    rgba.set(src.subarray(0, rgba.length));
  } else {
    for (let y = 0; y < h; y++) {
      const row = y * bytesPerRow;
      rgba.set(src.subarray(row, row + unpaddedRow), y * unpaddedRow);
    }
  }
  buffer.unmap();
  buffer.destroy();

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
  return canvas;
}
