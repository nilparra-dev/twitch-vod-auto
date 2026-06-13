import functools
import logging
import random
import time

log = logging.getLogger("retry")


def retry_with_backoff(
    max_retries: int = 3, base_delay: float = 2.0, max_delay: float = 60.0, exceptions=(Exception,), on_retry=None
):
    """
    Decorador de retry con backoff exponencial + jitter.

    Args:
        max_retries: numero maximo de intentos
        base_delay: delay base en segundos
        max_delay: delay maximo en segundos
        exceptions: tupla de excepciones a capturar
        on_retry: callback opcional (func(exception, attempt))
    """

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(1, max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    if attempt == max_retries:
                        log.error("[Retry] Max retries alcanzado para %s: %s", func.__name__, e)
                        raise
                    delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
                    jitter = random.uniform(0, delay * 0.3)
                    sleep_time = delay + jitter
                    log.warning(
                        "[Retry] %s fallo (intento %d/%d): %s. Reintentando en %.1fs...",
                        func.__name__,
                        attempt,
                        max_retries,
                        e,
                        sleep_time,
                    )
                    if on_retry:
                        on_retry(e, attempt)
                    time.sleep(sleep_time)

        return wrapper

    return decorator


if __name__ == "__main__":

    @retry_with_backoff(max_retries=3, base_delay=1.0)
    def fail_twice():
        fail_twice.calls = getattr(fail_twice, "calls", 0) + 1
        if fail_twice.calls < 3:
            raise RuntimeError("fallo simulado")
        return "ok"

    print(fail_twice())
