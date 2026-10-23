// Thin wrapper over the preload bridge. `call` throws real Errors.

const bridge = window.pult;

export async function call(channel, ...args) {
  const r = await bridge.invoke(channel, ...args);
  if (r && r.ok === false) {
    const err = new Error(r.error.message);
    err.code = r.error.code;
    throw err;
  }
  return r ? r.value : undefined;
}

export const raw = (channel, ...args) => bridge.invoke(channel, ...args);
export const send = (channel, ...args) => bridge.send(channel, ...args);
export const on = (channel, fn) => bridge.on(channel, fn);
export const pathForFile = (file) => bridge.pathForFile(file);
