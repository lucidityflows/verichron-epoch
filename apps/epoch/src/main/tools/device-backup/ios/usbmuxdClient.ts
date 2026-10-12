import * as net from 'node:net';
import { EventEmitter } from 'node:events';

export interface UsbmuxDevice {
  DeviceID: number;
  Properties: {
    SerialNumber: string;
    DeviceName?: string;
    ProductID: number;
    LocationID: number;
  };
}

export class UsbmuxdClient extends EventEmitter {
  private socketPath: string;
  private client: net.Socket | null = null;

  constructor(
    socketPath: string = globalThis.process?.platform === 'win32' ? '\\\\.\\pipe\\usbmuxd' : '/var/run/usbmuxd'
  ) {
    super();
    this.socketPath = socketPath;
  }

  public connect(): void {
    this.client = net.createConnection(this.socketPath, () => {
      const plistPayload = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` +
          `<plist version="1.0"><dict>` +
          `<key>ClientVersionString</key><string>EpochForensics</string>` +
          `<key>MessageType</key><string>Listen</string>` +
          `<key>ProgName</key><string>Epoch</string>` +
          `</dict></plist>`,
        'utf8'
      );

      const header = Buffer.alloc(16);
      header.writeUInt32LE(plistPayload.length + 16, 0);
      header.writeUInt32LE(1, 4);
      header.writeUInt32LE(8, 8);
      header.writeUInt32LE(0, 12);

      this.client?.write(Buffer.concat([header, plistPayload]));
    });

    this.client.on('data', (data: Buffer) => {
      this.parseIncomingData(data);
    });

    this.client.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private parseIncomingData(data: Buffer): void {
    if (data.length < 16) return;
    const msgType = data.toString('utf8', 20, 40);
    if (msgType.includes('Attached')) {
      this.emit('attached', data);
    } else if (msgType.includes('Detached')) {
      this.emit('detached', data);
    }
  }

  public disconnect(): void {
    this.client?.end();
    this.client = null;
  }
}
