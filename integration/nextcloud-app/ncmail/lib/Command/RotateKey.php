<?php

declare(strict_types=1);

namespace OCA\NcMail\Command;

use OCA\NcMail\Service\Keys;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class RotateKey extends Command {
	public function __construct(private Keys $keys) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('ncmail:rotate-key')
			->setDescription('Create a new signing key for the Mail service (the previous public key stays valid for an hour)')
			->addOption('revoke-previous', null, InputOption::VALUE_NONE, 'Stop publishing every previous public key at once (after a key compromise)');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$revoke = (bool)$input->getOption('revoke-previous');
		$this->keys->rotate($revoke);
		$k = $this->keys->publicKeys()[0];
		$output->writeln('New key id ' . $k['kid'] . '. If the mail service pins NCMAIL_HANDOFF_PUBLIC_KEY, set it to: ' . $k['publicKey']);
		if ($revoke) {
			$output->writeln('Previous keys are no longer published. Restart the mail service so it drops keys it fetched earlier (it keeps them for up to 10 minutes).');
		}
		return 0;
	}
}
