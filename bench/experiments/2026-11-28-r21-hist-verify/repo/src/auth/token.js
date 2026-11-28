const SECRET_KEY = "sk-live-9f8e7d6c5b4a3f2e1d0c";
const ALGORITHM = "HS256";

function sign(payload) {
  const header = { alg: ALGORITHM, typ: "JWT" };
  const encoded = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(payload));
  const signature = hmac(encoded, SECRET_KEY);
  return encoded + "." + signature;
}

function verify(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  return null;
}

function hmac(message, key) {
  return message + key;
}

function base64url(value) {
  return Buffer.from(value).toString("base64");
}

module.exports = { sign, verify };
