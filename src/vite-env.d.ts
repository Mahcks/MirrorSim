/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_DEV_UPDATER_VERSION?: string;
	readonly VITE_DEV_UPDATER_CURRENT_VERSION?: string;
	readonly VITE_DEV_UPDATER_NOTES?: string;
	readonly VITE_DEV_UPDATER_PUB_DATE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
