<?php

declare(strict_types=1);

namespace OCA\NcMail\Service;

use OCP\IAppConfig;

/**
 * The Ed25519 key pair this Nextcloud signs with. The private key is stored encrypted in Nextcloud's app config and never leaves it;
 * the mail service only gets the public key (it fetches it from /apps/ncmail/key, or an admin pins it).
 * After a rotation the previous public keys stay listed for a while, so tokens signed just before still verify.
 */
class Keys {
	public function __construct(private IAppConfig $config) {
	}

	public static function b64u(string $raw): string {
		return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
	}

	private function ensure(): void {
		if ($this->config->getValueString('ncmail', 'privateKey', '') !== '') {
			return;
		}
		$pair = sodium_crypto_sign_keypair();
		$public = sodium_crypto_sign_publickey($pair);
		$this->config->setValueString('ncmail', 'privateKey', base64_encode(sodium_crypto_sign_secretkey($pair)), false, true);
		$this->config->setValueString('ncmail', 'publicKey', base64_encode($public));
		$this->config->setValueString('ncmail', 'kid', substr(hash('sha256', $public), 0, 12));
	}

	/** @param bool $revokePrevious drop every earlier public key at once (after a key compromise) instead of listing them for an hour */
	public function rotate(bool $revokePrevious = false): void {
		$old = $revokePrevious ? [] : (json_decode($this->config->getValueString('ncmail', 'previousKeys', '[]'), true) ?: []);
		$current = $this->config->getValueString('ncmail', 'publicKey', '');
		if ($current !== '' && !$revokePrevious) {
			$old[] = ['kid' => $this->config->getValueString('ncmail', 'kid', ''), 'publicKey' => $current, 'until' => time() + 3600];
		}
		$this->config->setValueString('ncmail', 'previousKeys', json_encode($old));
		$this->config->deleteKey('ncmail', 'privateKey');
		$this->ensure();
	}

	/** @return array{kid: string, publicKey: string}[] the current key first, then recently retired ones */
	public function publicKeys(): array {
		$this->ensure();
		$keys = [['kid' => $this->config->getValueString('ncmail', 'kid', ''), 'publicKey' => $this->config->getValueString('ncmail', 'publicKey', '')]];
		foreach (json_decode($this->config->getValueString('ncmail', 'previousKeys', '[]'), true) ?: [] as $k) {
			if (($k['until'] ?? 0) > time()) {
				$keys[] = ['kid' => $k['kid'], 'publicKey' => $k['publicKey']];
			}
		}
		return $keys;
	}

	public function sign(string $message): string {
		$this->ensure();
		return self::b64u(sodium_crypto_sign_detached($message, base64_decode($this->config->getValueString('ncmail', 'privateKey', ''))));
	}
}
