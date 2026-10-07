package main

import "crypto/tls"

func clients() (*tls.Config, *tls.Config) {
	// ruleid: radr.go.tls-insecure-skip-verify
	bad := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}
	cfg := &tls.Config{}
	// ruleid: radr.go.tls-insecure-skip-verify
	cfg.InsecureSkipVerify = true
	// ok: radr.go.tls-insecure-skip-verify
	good := &tls.Config{MinVersion: tls.VersionTLS12}
	_ = good
	return bad, cfg
}
