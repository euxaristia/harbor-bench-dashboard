## 2025-01-28 - Explicit `http.Server` timeouts
**Vulnerability:** Default `http.ListenAndServe` in Go lacks read and write timeouts, exposing the application to Slowloris and connection exhaustion Denial of Service (DoS) attacks.
**Learning:** This is a common architectural gap in Go applications where default HTTP handlers are used without custom timeout configurations.
**Prevention:** Always use a custom `http.Server` struct with explicit `ReadTimeout`, `WriteTimeout`, and `IdleTimeout` configured to mitigate resource exhaustion vulnerabilities.