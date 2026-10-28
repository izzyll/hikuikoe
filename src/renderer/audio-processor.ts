// Corre en el hilo de audio: agrupa los bloques de 128 muestras en frames de ~30 ms
// y los manda al hilo principal, donde se hace la detección de voz.
class CaptureProcessor extends AudioWorkletProcessor {
  private frameSize = Math.round(sampleRate * 0.03);
  private buffer = new Float32Array(this.frameSize);
  private offset = 0;

  process(inputs: Float32Array[][]) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const length = channels[0].length;

    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const ch of channels) sample += ch[i];
      this.buffer[this.offset++] = sample / channels.length;
      if (this.offset === this.frameSize) {
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
