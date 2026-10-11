export const NAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 8;
export const MAX_GOALS = 99;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateName(name = "") {
  if (!name) {
    return "Name is required.";
  }

  if (name.length < 2) {
    return "Name must be at least 2 characters.";
  }

  if (name.length > NAME_MAX_LENGTH) {
    return `Name must be ${NAME_MAX_LENGTH} characters or fewer.`;
  }

  return null;
}

export function validateEmail(email = "") {
  if (!email) {
    return "Email is required.";
  }

  if (!EMAIL_PATTERN.test(email)) {
    return "Enter a valid email address.";
  }

  return null;
}

export function validateScore(value, label = "Score") {
  if (value === undefined || value === null || value === "") {
    return `${label} is required.`;
  }

  const score = Number(value);

  if (!Number.isInteger(score) || score < 0 || score > MAX_GOALS) {
    return `${label} must be a whole number between 0 and ${MAX_GOALS}.`;
  }

  return null;
}

export function validatePassword(password = "") {
  if (!password) {
    return "Password is required.";
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }

  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return "Password must include a letter and a number.";
  }

  return null;
}