package main

import (
	"fmt"
	"os"

	"github.com/google/uuid"
)

func ID() string { return uuid.NewString() }

func Add(a, b int) int { return a + b }

func main() {
	fmt.Printf("%d\n", ID())
	os.Remove("/tmp/x")
}
