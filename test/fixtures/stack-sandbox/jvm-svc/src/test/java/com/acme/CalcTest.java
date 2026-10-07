package com.acme;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class CalcTest {
    @Test
    public void adds() {
        assertEquals(5, Calc.add(2, 3));
    }
}
