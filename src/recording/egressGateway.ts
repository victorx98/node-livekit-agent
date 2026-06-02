import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from "livekit-server-sdk";
import type { EgressGateway } from "./recorder.js";

// Thin LiveKit Egress adapter (§16). The only module that talks to the LiveKit
// Egress API. It builds a Room Composite Egress that writes a single file
// (MP4 video, or OGG when audio-only) directly to S3, and implements the
// EgressGateway contract the Recorder depends on. No policy lives here.

export interface EgressS3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}

export interface EgressGatewayConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  s3: EgressS3Config;
}

export class LiveKitEgressGateway implements EgressGateway {
  private readonly client: EgressClient;

  constructor(private readonly config: EgressGatewayConfig) {
    this.client = new EgressClient(
      config.livekitUrl,
      config.livekitApiKey,
      config.livekitApiSecret,
    );
  }

  async start(roomName: string, filepath: string, audioOnly: boolean): Promise<string> {
    const s3 = new S3Upload({
      accessKey: this.config.s3.accessKeyId,
      secret: this.config.s3.secretAccessKey,
      bucket: this.config.s3.bucket,
      region: this.config.s3.region,
    });

    const output = new EncodedFileOutput({
      fileType: audioOnly ? EncodedFileType.OGG : EncodedFileType.MP4,
      filepath,
      output: { case: "s3", value: s3 },
    });

    const info = await this.client.startRoomCompositeEgress(roomName, output, { audioOnly });
    return info.egressId;
  }

  async stop(egressId: string): Promise<void> {
    await this.client.stopEgress(egressId);
  }
}
