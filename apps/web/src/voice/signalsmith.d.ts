declare module "signalsmith-stretch" {
  export interface StretchNode extends AudioWorkletNode {
    schedule(options: {
      active?: boolean; semitones?: number; tonalityHz?: number;
      formantSemitones?: number; formantCompensation?: boolean; formantBaseHz?: number;
    }): Promise<void>;
    latency(): number;
  }
  export default function SignalsmithStretch(ctx: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
}
