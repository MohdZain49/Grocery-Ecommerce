import jwt from "jsonwebtoken";

const authUser = async (req, res, next) => {
  const { token } = req.cookies;

  if (!token) {
    return res.json({
      success: false,
      message: "Not Authorized",
    });
  }

  try {
    const decodedToken = jwt.verify(token, process.env.JWT_SECRET);
    if (decodedToken.id) {
      req.userId = decodedToken.id;
    } else {
      return res.json({
        success: false,
        message: "Not Authorized",
      });
    }
    next();
  } catch (error) {
    return res.json({
      success: false,
      message: error.message,
      dikkat: "yahan se hai",
    });
  }
};

export default authUser;
