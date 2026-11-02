import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * secret 加密密钥：优先 TESTFORGE_SECRET_KEY（64 位 hex = 32 字节），
 * 没有时自动生成本机密钥文件 data/secret.key（0600），只在本地单机部署下够用。
 */
const KEY_ENV = "TESTFORGE_SECRET_KEY";

let cachedKey: Buffer | null = null;

export function getSecretKey(dataDir: string = path.resolve("data")): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env[KEY_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const buf = Buffer.from(fromEnv, "hex");
    if (buf.length !== 32) {
      throw new Error(`${KEY_ENV} 需要是 64 位 hex（32 字节），当前长度不对`);
    }
    cachedKey = buf;
    return cachedKey;
  }
  const keyFile = path.join(dataDir, "secret.key");
  if (fs.existsSync(keyFile)) {
    const buf = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
    if (buf.length !== 32) throw new Error(`密钥文件 ${keyFile} 内容不合法`);
    cachedKey = buf;
    return cachedKey;
  }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, fresh.toString("hex"), { mode: 0o600 });
  cachedKey = fresh;
  return cachedKey;
}

/** AES-256-GCM：返回 [12字节IV][16字节tag][密文]，存进 vars.value BLOB。 */
export function encryptSecret(plain: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptSecret(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const data = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

/** 值长度不定：不管是不是 secret，快照/日志统一把 secret 值替换成固定掩码。 */
export const SECRET_MASK = "********";

export function redactValue(isSecret: boolean, value: string): string {
  return isSecret ? SECRET_MASK : value;
}
