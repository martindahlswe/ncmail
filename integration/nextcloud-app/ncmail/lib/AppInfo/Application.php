<?php

declare(strict_types=1);

namespace OCA\NcMail\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\NcMail\Listener\FilesScriptsListener;
use OCA\NcMail\Listener\NavBadgeListener;
use OCA\NcMail\Listener\UserGoneListener;
use OCA\NcMail\Notification\Notifier;
use OCA\NcMail\Search\MailSearchProvider;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\User\Events\BeforeUserLoggedOutEvent;
use OCP\User\Events\UserDeletedEvent;

class Application extends App implements IBootstrap {
	public const APP_ID = 'ncmail';

	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		// Mail's session ends when the Nextcloud one does
		$context->registerEventListener(BeforeUserLoggedOutEvent::class, UserGoneListener::class);
		$context->registerEventListener(UserDeletedEvent::class, UserGoneListener::class);
		// unread count on Mail's menu entry
		$context->registerEventListener(BeforeTemplateRenderedEvent::class, NavBadgeListener::class);
		// Nextcloud's global search finds mail
		$context->registerSearchProvider(MailSearchProvider::class);
		// new mail in Nextcloud's notifications (filled by BackgroundJob\NewMailJob)
		$context->registerNotifierService(Notifier::class);
		// "Send by mail" in Files
		$context->registerEventListener(LoadAdditionalScriptsEvent::class, FilesScriptsListener::class);
	}

	public function boot(IBootContext $context): void {
	}
}
