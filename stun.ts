import { createSocket } from "node:dgram";

const PORT = Number(process.env.STUN_PORT ?? 3478);
const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

function xorPort(port: number) {
  return port ^ (MAGIC_COOKIE >>> 16);
}

function xorIpv4(address: string) {
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC_COOKIE);
  return Buffer.from(address.split(".").map((octet, i) => Number(octet) ^ cookie[i]!));
}

function bindingSuccess(transactionId: Buffer, address: string, port: number) {
  const value = Buffer.alloc(8);
  value.writeUInt8(0x01, 1); // IPv4
  value.writeUInt16BE(xorPort(port), 2);
  xorIpv4(address).copy(value, 4);

  const attr = Buffer.alloc(4 + value.length);
  attr.writeUInt16BE(XOR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(value.length, 2);
  value.copy(attr, 4);

  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);

  return Buffer.concat([header, attr]);
}

const socket = createSocket("udp4");

socket.on("message", (msg, rinfo) => {
  if (msg.length < 20) return;
  const type = msg.readUInt16BE(0);
  if (type !== BINDING_REQUEST) return;

  const reply = bindingSuccess(msg.subarray(8, 20), rinfo.address, rinfo.port);
  socket.send(reply, rinfo.port, rinfo.address);
});

socket.on("listening", () => {
  const addr = socket.address();
  console.log(`stun listening udp://${addr.address}:${addr.port}`);
});

socket.on("error", (err) => {
  console.error("stun error", err);
  process.exit(1);
});

socket.bind(PORT, "0.0.0.0");
