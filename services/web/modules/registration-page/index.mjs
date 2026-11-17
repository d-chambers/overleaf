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

  // For deployments without email (e.g. a trusted private network): send the
  // new user straight to the set-password page instead of emailing the link.
  Settings.registrationShowActivationLink =
    boolFromEnv(process.env.OVERLEAF_REGISTRATION_SHOW_ACTIVATION_LINK) === true

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
