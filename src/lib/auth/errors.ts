/**
 * GATHR — Centralized Authentication Error Mapping
 *
 * Normalizes and translates all OAuth, credential, OTP, and network error codes
 * into user-friendly, actionable, and secure messages.
 *
 * Security rules:
 * - Never expose internal stack traces or database errors.
 * - Never reveal whether an arbitrary email is registered.
 * - Do not fabricate OAuth details.
 * - Map cancelation (access_denied) to a calm, non-alarming notice.
 */

export interface AuthErrorInfo {
  /** The normalized machine error code */
  code: string;
  /** Human-readable, actionable message */
  message: string;
  /** Whether the UI should display a link to /verify-email */
  showVerifyLink?: boolean;
  /** Action label if applicable */
  actionLabel?: string;
  /** Action link destination */
  actionTo?: string;
}

const ERROR_MAP: Record<string, AuthErrorInfo> = {
  account_not_linked: {
    code: "account_not_linked",
    message:
      "An account with this email already exists. Sign in with your email and password, verify your email, then you can connect Google from your account settings.",
    showVerifyLink: true,
    actionLabel: "Verify your email",
    actionTo: "/verify-email",
  },
  email_not_verified: {
    code: "email_not_verified",
    message:
      "Google could not verify your email address. Please sign in with your email and password instead.",
    showVerifyLink: false,
  },
  unable_to_link_account: {
    code: "unable_to_link_account",
    message:
      "Could not link your Google account. Please try again or sign in with your email and password.",
    showVerifyLink: false,
  },
  account_already_linked_to_different_user: {
    code: "account_already_linked_to_different_user",
    message:
      "This Google account is already connected to a different workspace. Please sign in with your email and password.",
    showVerifyLink: false,
  },
  email_does_not_match: {
    code: "email_does_not_match",
    message:
      "The email address on this Google account does not match your workspace account email.",
    showVerifyLink: false,
  },
  "email_doesn't_match": {
    code: "email_does_not_match",
    message:
      "The email address on this Google account does not match your workspace account email.",
    showVerifyLink: false,
  },
  access_denied: {
    code: "access_denied",
    message: "Google sign-in was cancelled. You can try again or continue with email.",
    showVerifyLink: false,
  },
  oauth_provider_not_found: {
    code: "oauth_provider_not_found",
    message: "The requested authentication provider is not supported or not configured.",
    showVerifyLink: false,
  },
  invalid_code: {
    code: "invalid_code",
    message: "The sign-in request was invalid or timed out. Please try again.",
    showVerifyLink: false,
  },
  no_code: {
    code: "no_code",
    message: "Google sign-in did not return an authorization code. Please try again.",
    showVerifyLink: false,
  },
  // OTP errors
  invalid_otp: {
    code: "invalid_otp",
    message: "Invalid verification code. Please check the code in your email and try again.",
    showVerifyLink: false,
  },
  expired_otp: {
    code: "expired_otp",
    message: "This verification code has expired. Please request a new code below.",
    showVerifyLink: false,
  },
  otp_expired: {
    code: "expired_otp",
    message: "This verification code has expired. Please request a new code below.",
    showVerifyLink: false,
  },
  too_many_attempts: {
    code: "too_many_attempts",
    message: "Too many failed attempts. For your security, please request a new verification code.",
    showVerifyLink: false,
  },
  // Credential errors
  invalid_credentials: {
    code: "invalid_credentials",
    message: "Invalid email or password. Please check your credentials and try again.",
    showVerifyLink: false,
  },
  invalid_email_or_password: {
    code: "invalid_credentials",
    message: "Invalid email or password. Please check your credentials and try again.",
    showVerifyLink: false,
  },
  // Delivery & network errors
  delivery_failure: {
    code: "delivery_failure",
    message:
      "Could not deliver the verification email. Please confirm your email address and try again.",
    showVerifyLink: false,
  },
  network_error: {
    code: "network_error",
    message:
      "Unable to reach the authentication service. Please check your network connection and try again.",
    showVerifyLink: false,
  },
};

/**
 * Normalizes an error string or code and returns a safe, actionable AuthErrorInfo.
 */
export function getAuthErrorMessage(
  errorCodeOrMessage: string | null | undefined,
): AuthErrorInfo | null {
  if (!errorCodeOrMessage) return null;

  const raw = errorCodeOrMessage.trim();
  if (!raw) return null;

  // Check direct lowercase / normalized key
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");

  if (ERROR_MAP[normalized]) {
    return ERROR_MAP[normalized];
  }

  // Common substring / message checks for Better Auth responses
  if (
    normalized.includes("not_verified") ||
    normalized.includes("verify_your_email") ||
    normalized.includes("email_not_verified")
  ) {
    return {
      code: "email_not_verified",
      message: "Please verify your email before signing in.",
      showVerifyLink: true,
      actionLabel: "Verify email",
      actionTo: "/verify-email",
    };
  }

  if (
    normalized.includes("invalid_email_or_password") ||
    normalized.includes("invalid_credentials") ||
    normalized.includes("credentials")
  ) {
    return ERROR_MAP.invalid_credentials;
  }

  if (normalized.includes("invalid_otp") || normalized.includes("invalid_code")) {
    return ERROR_MAP.invalid_otp;
  }

  if (normalized.includes("otp_expired") || normalized.includes("expired")) {
    return ERROR_MAP.expired_otp;
  }

  if (normalized.includes("too_many_attempts") || normalized.includes("rate_limit")) {
    return ERROR_MAP.too_many_attempts;
  }

  if (normalized.includes("network") || normalized.includes("failed_to_fetch")) {
    return ERROR_MAP.network_error;
  }

  if (normalized.includes("access_denied") || normalized.includes("cancelled")) {
    return ERROR_MAP.access_denied;
  }

  if (normalized.includes("account_not_linked")) {
    return ERROR_MAP.account_not_linked;
  }

  if (
    normalized.includes("delivery") ||
    normalized.includes("resend") ||
    normalized.includes("testing_email_address") ||
    normalized.includes("invalid_to")
  ) {
    return ERROR_MAP.delivery_failure;
  }

  // Fallback for unknown server strings — never leak raw exception messages
  return {
    code: "unknown_error",
    message: "An unexpected authentication error occurred. Please try again.",
    showVerifyLink: false,
  };
}
