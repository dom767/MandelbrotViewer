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

  const device = await adapter.requestDevice();
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
