<?php

declare(strict_types=1);

namespace OCA\NcMail\Service;

use OCP\App\IAppManager;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use OCP\Security\ISecureRandom;
use Psr\Log\LoggerInterface;

/** Signed calls from Nextcloud to the mail service (menu badge, search, sign-out, handing over an app password). */
class MailClient {
	public function __construct(
		private IAppConfig $config,
		private Keys $keys,
		private IClientService $http,
		private ISecureRandom $random,
		private LoggerInterface $logger,
		private IAppManager $apps,
	) {
	}

	/** The oldest mail service this app works with. Raise it when this app starts relying on something new in the service. */
	public const MIN_SERVICE_VERSION = '0.1.0';

	/** This app's version (appinfo/info.xml); sent with every call so the service can tell an out-of-step update. */
	public function appVersion(): string {
		return $this->apps->getAppVersion('ncmail');
	}

	/** Where the browser reaches the mail service. */
	public function publicUrl(): string {
		return rtrim($this->config->getValueString('ncmail', 'url', 'http://localhost:4000'), '/');
	}

	/** Where Nextcloud's server reaches it (set when that differs, for example inside a container network). */
	private function serverUrl(): string {
		return rtrim($this->config->getValueString('ncmail', 'serverUrl', '') ?: $this->publicUrl(), '/');
	}

	/**
	 * The host the request goes to, as its Host header names it (lower case, without a default port). It is part of the signature,
	 * so a request signed for this mail service cannot be replayed at another one.
	 */
	private function serverHost(): string {
		$p = parse_url($this->serverUrl());
		$host = strtolower(($p['host'] ?? '') . (isset($p['port']) ? ':' . $p['port'] : ''));
		return (string)preg_replace('/:(80|443)$/', '', $host);
	}

	/** Signature version 2 (over the target host too); needs mail service 0.2.1 or newer. */
	public function sign(string $method, string $pathAndQuery, string $body): array {
		$ts = time();
		$nonce = bin2hex(random_bytes(12));
		$msg = implode("\n", ['ncmail-s2s-v2', $method, $this->serverHost(), $pathAndQuery, (string)$ts, $nonce, hash('sha256', $body)]);
		return ['X-Ncmail-Ts' => (string)$ts, 'X-Ncmail-Nonce' => $nonce, 'X-Ncmail-Sig-Version' => '2', 'X-Ncmail-Sig' => $this->keys->sign($msg)];
	}

	/**
	 * Like call(), but keeps the service's answer when it refuses (status and message), for pages that show it to an administrator.
	 * @return array{status: int, body: array<string, mixed>} status 0 when the service could not be reached
	 */
	public function request(string $method, string $path, ?array $body = null, float $timeout = 10.0): array {
		$raw = $body === null ? '' : json_encode($body);
		$headers = $this->sign($method, $path, $raw) + ['Accept' => 'application/json', 'X-Ncmail-App-Version' => $this->appVersion()];
		if ($body !== null) {
			$headers['Content-Type'] = 'application/json';
		}
		$options = ['headers' => $headers, 'timeout' => $timeout, 'http_errors' => false, 'nextcloud' => ['allow_local_address' => true]];
		if ($body !== null) {
			$options['body'] = $raw;
		}
		try {
			$client = $this->http->newClient();
			$res = $method === 'GET' ? $client->get($this->serverUrl() . $path, $options) : $client->post($this->serverUrl() . $path, $options);
			$data = json_decode((string)$res->getBody(), true);
			return ['status' => $res->getStatusCode(), 'body' => is_array($data) ? $data : []];
		} catch (\Throwable $e) {
			$this->logger->warning('Mail service call failed: ' . $e->getMessage(), ['app' => 'ncmail']);
			return ['status' => 0, 'body' => ['error' => 'The mail service at ' . $this->serverUrl() . ' could not be reached.']];
		}
	}

	/** @return array<string, mixed>|null null when the service could not be reached or refused */
	public function call(string $method, string $path, array $query = [], ?array $body = null, float $timeout = 3.0): ?array {
		$pq = $path . ($query ? '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '');
		$raw = $body === null ? '' : json_encode($body);
		$headers = $this->sign($method, $pq, $raw) + ['Accept' => 'application/json', 'X-Ncmail-App-Version' => $this->appVersion()];
		if ($body !== null) {
			$headers['Content-Type'] = 'application/json';
		}
		try {
			$client = $this->http->newClient();
			$options = ['headers' => $headers, 'timeout' => $timeout, 'nextcloud' => ['allow_local_address' => true]];
			if ($body !== null) {
				$options['body'] = $raw;
			}
			$res = $method === 'GET' ? $client->get($this->serverUrl() . $pq, $options) : $client->post($this->serverUrl() . $pq, $options);
			return json_decode($res->getBody(), true) ?: [];
		} catch (\Throwable $e) {
			$this->logger->info('Mail service call failed: ' . $e->getMessage(), ['app' => 'ncmail']);
			return null;
		}
	}
}
