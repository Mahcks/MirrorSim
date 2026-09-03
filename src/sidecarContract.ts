export type SidecarProcessTransport = "stdio-jsonl" | "named-pipe";

export type SidecarLaunchSpec = {
  executable: string;
  args: string[];
  workingDirectory: string;
  transport: SidecarProcessTransport;
  restartOnCrash: boolean;
};

export type SidecarCommandSpec = {
  name: string;
  payloadShape: string;
  description: string;
};

export type SidecarEventSpec = {
  name: string;
  payloadShape: string;
  description: string;
};

export type VideoAccessUnitPacketSpec = {
  codec: string;
  nalUnitFormat: string;
  timestampUnits: string;
  includesParameterSets: boolean;
  requiresKeyframesForRecovery: boolean;
};

export type AudioPacketSpec = {
  encoding: string;
  byteOrder: string;
  interleaved: boolean;
  timestampUnits: string;
  maximumChannels: number;
};

export type ReceiverSidecarSpec = {
  protocolVersion: string;
  launch: SidecarLaunchSpec;
  commands: SidecarCommandSpec[];
  events: SidecarEventSpec[];
  videoPacket: VideoAccessUnitPacketSpec;
  audioPacket: AudioPacketSpec;
};
