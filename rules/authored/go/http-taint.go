package main

import "net/http"

func handler(w http.ResponseWriter, r *http.Request) {
	next := r.FormValue("next")
	// ruleid: radr.go.open-redirect
	http.Redirect(w, r, next, http.StatusFound)
	// ok: radr.go.open-redirect
	http.Redirect(w, r, "/home", http.StatusFound)

	target := r.URL.Query().Get("url")
	// ruleid: radr.go.ssrf
	resp, _ := http.Get(target)
	_ = resp
	// ok: radr.go.ssrf
	resp2, _ := http.Get("https://api.example.com/status")
	_ = resp2
}
