/**
 * Public key that signed releases must verify against (Ed25519, SPKI PEM). Generate the pair once with
 * `node scripts/sign-release.mjs --generate-key release-signing.pem`, store the private key as the
 * GitHub secret RELEASE_SIGNING_KEY, and paste the printed public key here.
 */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAv8yzuR78HJ/n2CkCxWrxlejFS3z9vSE2kNSflbB+W9w=
-----END PUBLIC KEY-----
`;
