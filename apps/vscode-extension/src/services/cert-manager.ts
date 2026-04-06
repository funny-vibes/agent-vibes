import * as fs from "fs"
import * as forge from "node-forge"
import { logger } from "../utils/logger"
import { ConfigManager } from "./config-manager"
import { CURSOR_DOMAINS } from "../constants"

/**
 * Pure JavaScript certificate generation using node-forge.
 * Replaces the external mkcert dependency with a fully cross-platform solution.
 */
export class CertManager {
  constructor(private readonly config: ConfigManager) {}

  /** Check if valid certificates exist */
  hasCertificates(): boolean {
    return this.config.hasCertificates()
  }

  /**
   * Generate Root CA + Server certificate with all Cursor domains.
   * Everything is pure JS — zero external tool dependencies.
   */
  async generateCertificates(): Promise<{
    ca: string
    cert: string
    key: string
  }> {
    logger.info("Generating SSL certificates with node-forge...")

    // ── 1. Root CA ─────────────────────────────────────────────────────
    const caKeys = forge.pki.rsa.generateKeyPair(2048)
    const caCert = forge.pki.createCertificate()
    caCert.publicKey = caKeys.publicKey
    caCert.serialNumber = "01"
    caCert.validity.notBefore = new Date()
    caCert.validity.notAfter = new Date()
    caCert.validity.notAfter.setFullYear(
      caCert.validity.notBefore.getFullYear() + 10
    )

    const caAttrs: forge.pki.CertificateField[] = [
      { name: "commonName", value: "Agent Vibes Local CA" },
      { name: "organizationName", value: "Agent Vibes" },
    ]
    caCert.setSubject(caAttrs)
    caCert.setIssuer(caAttrs)
    caCert.setExtensions([
      { name: "basicConstraints", cA: true },
      {
        name: "keyUsage",
        keyCertSign: true,
        cRLSign: true,
      },
    ])
    caCert.sign(caKeys.privateKey, forge.md.sha256.create())

    // ── 2. Server Certificate ──────────────────────────────────────────
    const serverKeys = forge.pki.rsa.generateKeyPair(2048)
    const serverCert = forge.pki.createCertificate()
    serverCert.publicKey = serverKeys.publicKey
    serverCert.serialNumber = "02"
    serverCert.validity.notBefore = new Date()
    serverCert.validity.notAfter = new Date()
    serverCert.validity.notAfter.setFullYear(
      serverCert.validity.notBefore.getFullYear() + 2
    )

    const serverAttrs: forge.pki.CertificateField[] = [
      { name: "commonName", value: "localhost" },
      { name: "organizationName", value: "Agent Vibes" },
    ]
    serverCert.setSubject(serverAttrs)
    serverCert.setIssuer(caAttrs) // signed by CA

    // Build SAN list: all Cursor domains + prefixes + IPs

    const altNames: any[] = [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "127.0.0.2" },
      { type: 7, ip: "127.0.0.3" },
      { type: 7, ip: "::1" },
    ]

    for (const domain of CURSOR_DOMAINS) {
      altNames.push({ type: 2, value: domain })
      altNames.push({ type: 2, value: `*.${domain}` })
      altNames.push({ type: 2, value: `agent.${domain}` })
      altNames.push({ type: 2, value: `agentn.${domain}` })
    }

    // Add additional known subdomains
    const extraDomains = [
      "a.cursor.sh",
      "api2.cursor.sh",
      "api2geo.cursor.sh",
      "api2direct.cursor.sh",
    ]
    for (const d of extraDomains) {
      if (!altNames.some((a) => a.type === 2 && a.value === d)) {
        altNames.push({ type: 2, value: d })
      }
    }

    serverCert.setExtensions([
      { name: "basicConstraints", cA: false },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ])

    serverCert.sign(caKeys.privateKey, forge.md.sha256.create())

    // ── 3. Write to disk ───────────────────────────────────────────────
    const ca = forge.pki.certificateToPem(caCert)
    const caKey = forge.pki.privateKeyToPem(caKeys.privateKey)
    const cert = forge.pki.certificateToPem(serverCert)
    const key = forge.pki.privateKeyToPem(serverKeys.privateKey)

    fs.writeFileSync(this.config.caCertPath, ca)
    fs.writeFileSync(this.config.caKeyPath, caKey)
    fs.writeFileSync(this.config.serverCertPath, cert)
    fs.writeFileSync(this.config.serverKeyPath, key)

    logger.info(`CA certificate:     ${this.config.caCertPath}`)
    logger.info(`Server certificate: ${this.config.serverCertPath}`)
    logger.info(`Server key:         ${this.config.serverKeyPath}`)
    logger.info("SSL certificates generated successfully")

    return { ca, cert, key }
  }
}
