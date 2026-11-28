<?php

declare(strict_types=1);

namespace OCA\NcMail\Controller;

use OCA\NcMail\Service\Keys;
use OCA\NcMail\Service\MailClient;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Authentication\Token\IToken;
use OCP\IConfig;
use OCP\Lock\ILockingProvider;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use OCP\Notification\IManager as INotificationManager;
use OCP\Security\ISecureRandom;
use OCP\Util;

/**
 * Shows the mail service inside Nextcloud's own page (header, menu, theme) and vouches for the signed-in user:
 * the page asks /token for a short-lived signed token and passes it to the frame (see js/embed.js).
 */
class PageController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private Keys $keys,
		private MailClient $mail,
		private IUserSession $users,
		private IFactory $l10n,
		private ISecureRandom $random,
		private IURLGenerator $urls,
		private INotificationManager $notifications,
		private IConfig $config,
		private ILockingProvider $locks,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(?string $message = null, ?string $compose = null, ?string $subject = null, ?string $body = null, ?string $attach = null): TemplateResponse {
		$url = $this->mail->publicUrl();
		$this->clearSummary();
		Util::addStyle('ncmail', 'main');
		Util::addScript('ncmail', 'embed');
		$open = array_filter([
			'message' => $message !== null && ctype_digit($message) ? $message : null,
			'compose' => $compose, 'subject' => $subject, 'body' => $body,
			'attach' => $this->sameOrigin() ? $this->paths($attach) : [],
		], fn ($v) => $v !== null && $v !== '' && $v !== []);
		$response = new TemplateResponse('ncmail', 'main', ['url' => $url, 'origin' => $this->origin($url), 'tokenUrl' => $this->urls->linkToRoute('ncmail.page.token'), 'linkUrl' => $this->urls->linkToRoute('ncmail.page.link'), 'open' => json_encode($open, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)]);
		$csp = new ContentSecurityPolicy();
		$csp->addAllowedFrameDomain($url);
		$response->setContentSecurityPolicy($csp);
		return $response;
	}

	/**
	 * Files to attach, from "Send by mail" in Files: a JSON list of paths in the user's own files. Mail fetches them with the
	 * user's app password, so a path can only ever reach that user's files; nothing is sent until the user presses Send.
	 * @return string[]
	 */
	private function paths(?string $attach): array {
		$list = $attach === null ? null : json_decode($attach, true);
		if (!is_array($list)) {
			return [];
		}
		$out = [];
		foreach (array_slice($list, 0, 20) as $p) {
			if (is_string($p) && $p !== '' && strlen($p) <= 1024 && !str_contains($p, "\0")) {
				$out[] = $p;
			}
		}
		return $out;
	}

	/**
	 * Whether this page was opened from Nextcloud itself (or typed in). Files to attach are only taken from such a visit, so a link
	 * on another site cannot open the composer with the user's files already attached. Files' "Send by mail" is same-origin.
	 */
	private function sameOrigin(): bool {
		return in_array($this->request->getHeader('Sec-Fetch-Site'), ['same-origin', 'none'], true);
	}

	/** "N new messages" has done its job once Mail is open (single messages go away as they are read). */
	private function clearSummary(): void {
		$user = $this->users->getUser();
		if ($user === null) {
			return;
		}
		try {
			$this->notifications->markProcessed($this->notifications->createNotification()->setApp('ncmail')->setUser($user->getUID())->setObject('summary', 'new'));
		} catch (\Throwable) {
		}
	}

	private function origin(string $url): string {
		$p = parse_url($url);
		return ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '') . (isset($p['port']) ? ':' . $p['port'] : '');
	}

	/** A token that says who is signed in. Valid for a minute, usable once, signed with this Nextcloud's private key. */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 60, period: 60)]
	public function token(): JSONResponse {
		$user = $this->users->getUser();
		if ($user === null) {
			return new JSONResponse(['error' => 'not signed in'], 401);
		}
		$now = time();
		$payload = Keys::b64u(json_encode([
			'v' => 1, 'uid' => $user->getUID(), 'name' => $user->getDisplayName(), 'email' => (string)$user->getEMailAddress(),
			'lang' => $this->l10n->getUserLanguage($user), 'jti' => bin2hex(random_bytes(16)),
			'iat' => $now, 'exp' => $now + 60, 'aud' => $this->mail->publicUrl(),
		]));
		return new JSONResponse(['token' => 'v1.' . $payload . '.' . $this->keys->sign('ncmail-handoff-v1.' . $payload), 'expiresIn' => 60]);
	}

	/** The public half of the signing key: the mail service reads it here (it is not secret). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function key(): JSONResponse {
		$keys = $this->keys->publicKeys();
		return new JSONResponse(['kid' => $keys[0]['kid'], 'publicKey' => $keys[0]['publicKey'], 'keys' => $keys]);
	}

	/**
	 * Gives the mail service an app password for this user, so Files and Contacts work without another sign-in.
	 * Created only when the user opens Mail and it is not connected yet; revoked from Nextcloud's security page or by "Disconnect" in Mail.
	 * The token's id is kept per user, so linking again (or a failed hand-over) revokes exactly the one created here, never another
	 * app password the user happened to name "Mail".
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 5, period: 300)]
	public function link(): JSONResponse {
		$user = $this->users->getUser();
		if ($user === null) {
			return new JSONResponse(['error' => 'not signed in'], 401);
		}
		$provider = $this->legacyProvider();
		if ($provider === null) {
			return new JSONResponse(['linked' => false, 'reason' => 'unsupported'], 200);
		}
		$uid = $user->getUID();
		// One link at a time per user: two at once would each create an app password, and only one would be remembered
		// (and so ever revoked). Only app passwords this app remembers are revoked, never ones the user made, even if named "Mail".
		$lock = 'ncmail/link/' . $uid;
		try {
			$this->locks->acquireLock($lock, ILockingProvider::LOCK_EXCLUSIVE, 'Mail app password');
		} catch (\Throwable) {
			return new JSONResponse(['linked' => false, 'reason' => 'busy'], 409);
		}
		try {
			$previous = $this->config->getUserValue($uid, 'ncmail', 'appPasswordId', '');
			$password = $this->random->generate(72, ISecureRandom::CHAR_ALPHANUMERIC);
			$token = $provider->generateToken($password, $uid, $uid, null, 'Mail', IToken::PERMANENT_TOKEN, IToken::DO_NOT_REMEMBER);
			$this->config->setUserValue($uid, 'ncmail', 'appPasswordId', (string)$token->getId());
			$this->revokeId($provider, $uid, $previous); // the new one is remembered first, so none is ever left unremembered
			$ok = $this->mail->call('POST', '/api/internal/link', [], ['uid' => $uid, 'loginName' => $uid, 'appPassword' => $password]);
			if ($ok === null) {
				$this->revokeLinked($provider, $uid);
				return new JSONResponse(['linked' => false, 'reason' => 'unreachable'], 200);
			}
			return new JSONResponse(['linked' => true]);
		} finally {
			$this->locks->releaseLock($lock, ILockingProvider::LOCK_EXCLUSIVE);
		}
	}

	/** Revokes the app password this app last created for the user, if any (one the user already revoked is simply gone). */
	private function revokeLinked(object $provider, string $uid): void {
		$this->revokeId($provider, $uid, $this->config->getUserValue($uid, 'ncmail', 'appPasswordId', ''));
		$this->config->deleteUserValue($uid, 'ncmail', 'appPasswordId');
	}

	private function revokeId(object $provider, string $uid, string $id): void {
		if ($id !== '' && ctype_digit($id)) {
			try {
				$provider->invalidateTokenById($uid, (int)$id);
			} catch (\Throwable) {
			}
		}
	}

	/** Creating a token is not part of Nextcloud's public API; if a future version moves it, linking falls back to the manual "Connect" button in Mail. */
	private function legacyProvider(): ?object {
		$class = 'OC\\Authentication\\Token\\IProvider';
		try {
			return interface_exists($class) ? \OCP\Server::get($class) : null;
		} catch (\Throwable) {
			return null;
		}
	}
}
