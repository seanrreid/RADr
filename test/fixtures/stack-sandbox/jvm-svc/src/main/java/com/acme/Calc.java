package com.acme;

public class Calc {
    private int unused;

    public static int add(int a, int b) {
        try {
            return a + b;
        } catch (RuntimeException e) {
        }
        return 0;
    }
}
