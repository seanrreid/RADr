module Calc
  def self.add(a, b)
    unused = 1
    a + b
  end

  def self.run(expr)
    eval(expr)
  end
end
