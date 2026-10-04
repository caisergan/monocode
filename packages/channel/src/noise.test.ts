import { describe, expect, it } from "vitest";
import { fromHex, toHex, utf8 } from "./bytes";
import {
  IKInitiator,
  IKResponder,
  generateKeyPair,
  keyPairFromSecret,
  type NoiseTransport,
} from "./noise";
import cacophony from "./vectors/cacophony-ik.json";
import snow from "./vectors/snow-ik.json";

type Vector = {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_prologue: string;
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
};

function runVector(vector: Vector) {
  const initiator = new IKInitiator({
    staticKey: keyPairFromSecret(fromHex(vector.init_static)),
    remoteStatic: fromHex(vector.init_remote_static),
    prologue: fromHex(vector.init_prologue),
    ephemeral: keyPairFromSecret(fromHex(vector.init_ephemeral)),
  });
  const responder = new IKResponder({
    staticKey: keyPairFromSecret(fromHex(vector.resp_static)),
    prologue: fromHex(vector.resp_prologue),
    ephemeral: keyPairFromSecret(fromHex(vector.resp_ephemeral)),
  });
  const [first, second, ...rest] = vector.messages;

  const message1 = initiator.writeMessage1(fromHex(first.payload));
  expect(toHex(message1)).toBe(first.ciphertext);
  const read1 = responder.readMessage1(message1);
  expect(toHex(read1.payload)).toBe(first.payload);
  expect(toHex(read1.remoteStatic)).toBe(
    toHex(keyPairFromSecret(fromHex(vector.init_static)).publicKey),
  );

  const written2 = responder.writeMessage2(fromHex(second.payload));
  expect(toHex(written2.message)).toBe(second.ciphertext);
  const read2 = initiator.readMessage2(written2.message);
  expect(toHex(read2.payload)).toBe(second.payload);
  expect(toHex(read2.transport.handshakeHash)).toBe(toHex(written2.transport.handshakeHash));
  if (vector.handshake_hash)
    expect(toHex(read2.transport.handshakeHash)).toBe(vector.handshake_hash);

  // Transport messages alternate, starting with the initiator.
  const sides: [NoiseTransport, NoiseTransport] = [read2.transport, written2.transport];
  rest.forEach((message, index) => {
    const [sender, receiver] = index % 2 === 0 ? sides : [sides[1], sides[0]];
    const ciphertext = sender.send.encrypt(fromHex(message.payload));
    expect(toHex(ciphertext)).toBe(message.ciphertext);
    expect(toHex(receiver.receive.decrypt(ciphertext))).toBe(message.payload);
  });
}

describe("Noise_IK_25519_ChaChaPoly_SHA256", () => {
  it("matches the cacophony vector", () => {
    expect(cacophony).toHaveLength(1);
    runVector(cacophony[0] as Vector);
  });

  it("matches the snow vector", () => {
    expect(snow).toHaveLength(1);
    runVector(snow[0] as Vector);
  });

  it("completes a handshake with fresh keys and carries payloads both ways", () => {
    const host = generateKeyPair();
    const phone = generateKeyPair();
    const prologue = utf8("monocode/channel/1\0env");
    const initiator = new IKInitiator({ staticKey: phone, remoteStatic: host.publicKey, prologue });
    const responder = new IKResponder({ staticKey: host, prologue });
    const read = responder.readMessage1(initiator.writeMessage1(utf8("hello")));
    expect(read.remoteStatic).toEqual(phone.publicKey);
    const { message, transport } = responder.writeMessage2(utf8("welcome"));
    const client = initiator.readMessage2(message);
    expect(new TextDecoder().decode(client.payload)).toBe("welcome");
    const sealed = client.transport.send.encrypt(utf8("ping"));
    expect(new TextDecoder().decode(transport.receive.decrypt(sealed))).toBe("ping");
  });

  it("rejects a message 1 made for another host key or prologue", () => {
    const host = generateKeyPair();
    const other = generateKeyPair();
    const phone = generateKeyPair();
    const message = new IKInitiator({
      staticKey: phone,
      remoteStatic: other.publicKey,
      prologue: utf8("a"),
    }).writeMessage1(utf8("{}"));
    expect(() =>
      new IKResponder({ staticKey: host, prologue: utf8("a") }).readMessage1(message),
    ).toThrow();
    const right = new IKInitiator({
      staticKey: phone,
      remoteStatic: host.publicKey,
      prologue: utf8("a"),
    }).writeMessage1(utf8("{}"));
    expect(() =>
      new IKResponder({ staticKey: host, prologue: utf8("b") }).readMessage1(right),
    ).toThrow();
  });

  it("rejects replayed or reordered transport messages", () => {
    const host = generateKeyPair();
    const phone = generateKeyPair();
    const initiator = new IKInitiator({
      staticKey: phone,
      remoteStatic: host.publicKey,
      prologue: utf8("p"),
    });
    const responder = new IKResponder({ staticKey: host, prologue: utf8("p") });
    responder.readMessage1(initiator.writeMessage1(utf8("")));
    const { message, transport: hostSide } = responder.writeMessage2(utf8(""));
    const { transport: phoneSide } = initiator.readMessage2(message);
    const a = phoneSide.send.encrypt(utf8("a"));
    const b = phoneSide.send.encrypt(utf8("b"));
    expect(() => hostSide.receive.decrypt(b)).toThrow();
    // A failed decrypt does not advance the counter, but the channel is
    // closed after any failure; the in-order message still opens.
    expect(new TextDecoder().decode(hostSide.receive.decrypt(a))).toBe("a");
    expect(() => hostSide.receive.decrypt(a)).toThrow();
  });
});
