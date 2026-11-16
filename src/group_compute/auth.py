import jwt


class AuthenticationError(ValueError):
    pass


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
