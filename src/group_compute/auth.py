import hashlib
import hmac
import secrets
from threading import BoundedSemaphore
import jwt


class AuthenticationError(ValueError):
    pass


class RateLimited(AuthenticationError):
    pass


_password_slots = BoundedSemaphore(2)


def token_digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    with _password_slots:
        digest = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt),
                                n=131072, r=8, p=1, maxmem=256 * 1024**2).hex()
    return f"scrypt$131072$8$1${salt}${digest}"


def password_matches(password, encoded):
    # Run the same work for unknown accounts to avoid a cheap account-existence signal.
    candidate = encoded or "scrypt$131072$8$1$" + "00" * 16 + "$" + "00" * 64
    try:
        algorithm, n, r, p, salt, digest = candidate.split("$")
        if (algorithm, n, r, p) != ("scrypt", "131072", "8", "1"):
            return False
        return hmac.compare_digest(password_hash(password, salt), candidate) and bool(encoded)
    except (ValueError, TypeError):
        return False


class AccessAuthenticator:
    def __init__(self, issuer, audience, key_provider=None):
        self.issuer = issuer.rstrip("/")
        self.audience = audience
        self.client = None if key_provider else jwt.PyJWKClient(self.issuer + "/cdn-cgi/access/certs", cache_keys=True, lifespan=300, timeout=5)
        self.key_provider = key_provider

    def authenticate(self, token):
        try:
            if not token or len(token) > 16384:
                raise AuthenticationError("缺少有效登录信息")
            key = self.key_provider(token) if self.key_provider else self.client.get_signing_key_from_jwt(token).key
            data = jwt.decode(token, key, algorithms=["RS256"], issuer=self.issuer, audience=self.audience,
                              options={"require": ["iss", "aud", "exp", "iat", "sub", "email"]})
            if not isinstance(data["email"], str) or "@" not in data["email"]:
                raise AuthenticationError("登录身份没有邮箱")
            return data
        except (jwt.PyJWTError, ValueError, TypeError, OSError) as exc:
            raise AuthenticationError("登录信息无效或已过期") from exc
