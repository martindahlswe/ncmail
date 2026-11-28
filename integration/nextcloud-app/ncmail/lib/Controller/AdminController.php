<?php

declare(strict_types=1);

namespace OCA\NcMail\Controller;

use OCA\NcMail\Service\MailClient;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * The mail servers set up for everybody (Administration > Additional > Mail). Only administrators reach these routes (no
 * NoAdminRequired), and every call carries Nextcloud's CSRF token. The list is kept by the mail service, which this app
 * signs its calls to; a JSON file on the service (NCMAIL_MAIL_CONFIG) can add servers that are shown here read-only.
 */
class AdminController extends Controller {
	public function __construct(string $appName, IRequest $request, private MailClient $mail, private IUserSession $users) {
		parent::__construct($appName, $request);
	}

	private function relay(array $r): JSONResponse {
		$status = $r['status'] === 0 ? Http::STATUS_BAD_GATEWAY : $r['status'];
		return new JSONResponse($r['body'], $status);
	}

	/**
	 * This app's version and the mail service's, each with the oldest version of the other it works with. A service older
	 * than 0.4.2 has no version route; its public health check still says which version it is.
	 */
	public function versions(): JSONResponse {
		$app = ['version' => $this->mail->appVersion(), 'minServiceVersion' => MailClient::MIN_SERVICE_VERSION];
		$r = $this->mail->request('GET', '/api/internal/version', null, 8.0);
		if ($r['status'] === 404) {
			$h = $this->mail->request('GET', '/api/health', null, 8.0);
			if ($h['status'] === 200) {
				return new JSONResponse(['app' => $app, 'service' => ['version' => (string)($h['body']['version'] ?? ''), 'minAppVersion' => $h['body']['minAppVersion'] ?? null]]);
			}
			$r = $h;
		}
		if ($r['status'] !== 200) {
			return new JSONResponse(['app' => $app, 'service' => null, 'error' => $r['body']['error'] ?? ('The mail service answered with ' . $r['status'] . '.')]);
		}
		return new JSONResponse(['app' => $app, 'service' => ['version' => (string)($r['body']['version'] ?? ''), 'minAppVersion' => $r['body']['minAppVersion'] ?? null, 'otherInstances' => $r['body']['otherInstances'] ?? []]]);
	}

	public function servers(): JSONResponse {
		return $this->relay($this->mail->request('GET', '/api/internal/mail-servers'));
	}

	public function saveServers(array $config = []): JSONResponse {
		$uid = $this->users->getUser()?->getUID() ?? '';
		return $this->relay($this->mail->request('POST', '/api/internal/mail-servers', ['uid' => $uid, 'config' => $config]));
	}

	public function check(array $imap = [], array $smtp = [], ?array $sieve = null): JSONResponse {
		$body = ['imap' => $imap, 'smtp' => $smtp];
		if ($sieve) {
			$body['sieve'] = $sieve;
		}
		return $this->relay($this->mail->request('POST', '/api/internal/mail-servers/check', $body, 45.0));
	}

	public function checkAll(): JSONResponse {
		return $this->relay($this->mail->request('POST', '/api/internal/mail-servers/check-all', [], 120.0));
	}

	public function discover(string $domain = ''): JSONResponse {
		return $this->relay($this->mail->request('POST', '/api/internal/mail-servers/discover', ['domain' => $domain], 60.0));
	}
}
