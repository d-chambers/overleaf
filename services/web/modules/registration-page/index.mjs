import Settings from '@overleaf/settings'
import { boolFromEnv } from '../authentication/utils.mjs'

let RegistrationPageModule = {}

let enableRegistrationPage = boolFromEnv(process.env.OVERLEAF_ENABLE_REGISTRATION_PAGE)

// Self-registration is opt-in: only enabled when OVERLEAF_ENABLE_REGISTRATION_PAGE=true.
if (enableRegistrationPage === undefined) {
  enableRegistrationPage = false
}

if (enableRegistrationPage) {
  const { default: router } = await import('./app/src/RegistrationPageRouter.mjs')

  Settings.enableRegistrationPage = true

  if (process.env.OVERLEAF_ALLOWED_REGISTRATION_EMAIL_DOMAINS) {
    Settings.allowedRegistrationEmailDomains = process.env.OVERLEAF_ALLOWED_REGISTRATION_EMAIL_DOMAINS
      .split(/[,\s]+/)
      .filter(Boolean)
  }

  RegistrationPageModule = {
    name: 'registration-page',
    router: router,
  }
}

export default RegistrationPageModule
