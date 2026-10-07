pub fn render(n: u64) -> String {
    let mut buf = itoa::Buffer::new();
    buf.format(n).to_string()
}

pub fn is_empty(v: &Vec<u8>) -> bool {
    v.len() == 0
}

#[cfg(test)]
mod tests {
    #[test]
    fn renders() {
        assert_eq!(super::render(42), "42");
    }
}
