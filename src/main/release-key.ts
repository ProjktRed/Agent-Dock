/**
 * Public key that signed releases must verify against (Ed25519, SPKI PEM). Generate the pair once with
 * `node scripts/sign-release.mjs --generate-key release-signing.pem`, store the private key as the
 * GitHub secret RELEASE_SIGNING_KEY, and paste the printed public key here. While this is empty the
 * signed release channel is unavailable and the app keeps updating from git.
 */
export const RELEASE_PUBLIC_KEY = "";
